import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, DataSource } from "typeorm";
import { RecommendationFeedback } from "./entities/recommendation-feedback.entity";
import { TipStatus } from "../tips/entities/tip.entity";

type RecommendationTrackRow = {
  id: string;
  title: string;
  audioUrl: string;
  coverArtUrl: string | null;
  genre: string | null;
  artistId: string | null;
  artistName: string | null;
  score: string | number;
};

@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    @InjectRepository(RecommendationFeedback)
    private readonly feedbackRepo: Repository<RecommendationFeedback>,
    private readonly dataSource: DataSource,
  ) {}

  async getTrackRecommendations(
    userId: string,
    limit: number = 20,
  ): Promise<any[]> {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const tipCount = await this.getUserTipCount(userId);

    if (tipCount < 3) {
      return this.getPopularTracks(boundedLimit);
    }

    const collaborative = await this.collaborativeFilter(userId, boundedLimit);
    const contentBased = await this.contentBasedFilter(userId, boundedLimit);

    return this.mergeRecommendations(collaborative, contentBased, boundedLimit);
  }

  async getArtistRecommendations(userId: string): Promise<any[]> {
    const trackRecommendations = await this.getTrackRecommendations(userId, 30);
    const artists = new Map<string, any>();

    for (const track of trackRecommendations) {
      if (!track.artistId) {
        continue;
      }

      const existing = artists.get(track.artistId);
      if (existing) {
        existing.score += Number(track.score || 0);
        existing.trackCount += 1;
        continue;
      }

      artists.set(track.artistId, {
        id: track.artistId,
        artistName: track.artistName,
        genre: track.genre,
        score: Number(track.score || 0),
        trackCount: 1,
      });
    }

    return [...artists.values()]
      .sort((a, b) => b.score - a.score || b.trackCount - a.trackCount)
      .slice(0, 10);
  }

  async recordFeedback(
    userId: string,
    trackId: string,
    feedback: "up" | "down",
  ): Promise<RecommendationFeedback> {
    const existing = await this.feedbackRepo.findOne({
      where: { userId, trackId },
    });

    if (existing) {
      existing.feedback = feedback;
      return this.feedbackRepo.save(existing);
    }

    const entry = this.feedbackRepo.create({ userId, trackId, feedback });
    return this.feedbackRepo.save(entry);
  }

  private async getUserTipCount(userId: string): Promise<number> {
    const result = await this.dataSource.query(
      `SELECT COUNT(*)::int AS count
       FROM tips
       WHERE "fromUser" = $1
         AND status = $2`,
      [userId, TipStatus.VERIFIED],
    );

    return Number(result[0]?.count || 0);
  }

  private async collaborativeFilter(
    userId: string,
    limit: number,
  ): Promise<any[]> {
    const result = await this.dataSource.query(
      `WITH user_tracks AS (
         SELECT DISTINCT "trackId"
         FROM tips
         WHERE "fromUser" = $1
           AND status = $2
           AND "trackId" IS NOT NULL
       ),
       similar_users AS (
         SELECT t."fromUser" AS sender_id, COUNT(*)::int AS overlap
         FROM tips t
         INNER JOIN user_tracks ut ON ut."trackId" = t."trackId"
         WHERE t."fromUser" != $1
           AND t.status = $2
         GROUP BY t."fromUser"
         ORDER BY overlap DESC
         LIMIT 50
       ),
       disliked_tracks AS (
         SELECT "trackId"
         FROM recommendation_feedback
         WHERE "userId" = $1
           AND feedback = 'down'
       )
       SELECT tr.id,
              tr.title,
              tr."audioUrl",
              tr."coverArtUrl",
              tr.genre,
              tr."artistId",
              a."artistName" AS "artistName",
              COALESCE(SUM(su.overlap), 0)::int AS score
       FROM similar_users su
       INNER JOIN tips t
         ON t."fromUser" = su.sender_id
        AND t.status = $2
       INNER JOIN tracks tr
         ON tr.id = t."trackId"
       LEFT JOIN artists a
         ON a.id = tr."artistId"
       WHERE tr."isPublic" = true
         AND tr.id NOT IN (SELECT "trackId" FROM user_tracks)
         AND tr.id NOT IN (SELECT "trackId" FROM disliked_tracks)
       GROUP BY tr.id, a.id
       ORDER BY score DESC, tr.plays DESC, tr."createdAt" DESC
       LIMIT $3`,
      [userId, TipStatus.VERIFIED, limit],
    );

    return result.map((row: RecommendationTrackRow) =>
      this.mapTrackRow(row, "collaborative"),
    );
  }

  private async contentBasedFilter(
    userId: string,
    limit: number,
  ): Promise<any[]> {
    const result = await this.dataSource.query(
      `WITH user_genres AS (
         SELECT DISTINCT tr.genre
         FROM tips t
         INNER JOIN tracks tr ON tr.id = t."trackId"
         WHERE t."fromUser" = $1
           AND t.status = $2
           AND tr.genre IS NOT NULL
       ),
       user_tracks AS (
         SELECT DISTINCT "trackId"
         FROM tips
         WHERE "fromUser" = $1
           AND status = $2
           AND "trackId" IS NOT NULL
       ),
       disliked_tracks AS (
         SELECT "trackId"
         FROM recommendation_feedback
         WHERE "userId" = $1
           AND feedback = 'down'
       )
       SELECT tr.id,
              tr.title,
              tr."audioUrl",
              tr."coverArtUrl",
              tr.genre,
              tr."artistId",
              a."artistName" AS "artistName",
              COUNT(t.id)::int AS score
       FROM tracks tr
       INNER JOIN user_genres ug ON ug.genre = tr.genre
       LEFT JOIN artists a ON a.id = tr."artistId"
       LEFT JOIN tips t
         ON t."trackId" = tr.id
        AND t.status = $2
       WHERE tr."isPublic" = true
         AND tr.id NOT IN (SELECT "trackId" FROM user_tracks)
         AND tr.id NOT IN (SELECT "trackId" FROM disliked_tracks)
       GROUP BY tr.id, a.id
       ORDER BY score DESC, tr.plays DESC, tr."createdAt" DESC
       LIMIT $3`,
      [userId, TipStatus.VERIFIED, limit],
    );

    return result.map((row: RecommendationTrackRow) =>
      this.mapTrackRow(row, "content"),
    );
  }

  private async getPopularTracks(limit: number): Promise<any[]> {
    const result = await this.dataSource.query(
      `SELECT tr.id,
              tr.title,
              tr."audioUrl",
              tr."coverArtUrl",
              tr.genre,
              tr."artistId",
              a."artistName" AS "artistName",
              COUNT(t.id)::int AS score
       FROM tracks tr
       LEFT JOIN artists a ON a.id = tr."artistId"
       LEFT JOIN tips t
         ON t."trackId" = tr.id
        AND t.status = $1
       WHERE tr."isPublic" = true
       GROUP BY tr.id, a.id
       ORDER BY score DESC, tr.plays DESC, tr."createdAt" DESC
       LIMIT $2`,
      [TipStatus.VERIFIED, limit],
    );

    return result.map((row: RecommendationTrackRow) =>
      this.mapTrackRow(row, "popular"),
    );
  }

  private mergeRecommendations(
    collaborative: any[],
    contentBased: any[],
    limit: number,
  ): any[] {
    const collabCount = Math.ceil(limit * 0.6);
    const contentCount = limit - collabCount;

    const merged = [
      ...collaborative.slice(0, collabCount),
      ...contentBased.slice(0, contentCount),
    ];

    const seen = new Set<string>();
    return merged
      .filter((track) => {
        if (seen.has(track.id)) {
          return false;
        }

        seen.add(track.id);
        return true;
      })
      .slice(0, limit);
  }

  private mapTrackRow(row: RecommendationTrackRow, source: string) {
    return {
      id: row.id,
      title: row.title,
      audioUrl: row.audioUrl,
      coverArtUrl: row.coverArtUrl,
      genre: row.genre,
      artistId: row.artistId,
      artistName: row.artistName,
      score: Number(row.score || 0),
      source,
    };
  }
}
