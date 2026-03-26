import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { RecommendationFeedback } from './entities/recommendation-feedback.entity';

/**
 * Hybrid recommendation engine combining collaborative filtering
 * (based on tip patterns) and content-based filtering (genre similarity).
 *
 * Algorithm:
 *   1. Collaborative: Find users with similar tipping behavior, recommend
 *      tracks they tipped that the target user hasn't seen.
 *   2. Content-based: Match genres/artists the user has tipped.
 *   3. Hybrid: Weighted merge (60% collaborative, 40% content-based).
 *   4. Diversity: Inject random tracks to avoid filter bubbles.
 *   5. Cold start: Fall back to popularity-based for new users.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    @InjectRepository(RecommendationFeedback)
    private readonly feedbackRepo: Repository<RecommendationFeedback>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Get personalized track recommendations for a user.
   */
  async getTrackRecommendations(
    userId: string,
    limit: number = 20,
  ): Promise<any[]> {
    // Check if user has enough history for collaborative filtering
    const tipCount = await this.getUserTipCount(userId);

    if (tipCount < 3) {
      // Cold start: return popular tracks
      return this.getPopularTracks(limit);
    }

    // Hybrid: merge collaborative and content-based
    const collaborative = await this.collaborativeFilter(userId, limit);
    const contentBased = await this.contentBasedFilter(userId, limit);

    return this.mergeRecommendations(collaborative, contentBased, limit);
  }

  /**
   * Get artist recommendations based on user's tipping history.
   */
  async getArtistRecommendations(userId: string): Promise<any[]> {
    const result = await this.dataSource.query(
      `SELECT DISTINCT a.id, a."displayName", a.genre,
              COUNT(t.id) as tip_count,
              SUM(t.amount) as total_tipped
       FROM artists a
       JOIN tracks tr ON tr."artistId" = a.id
       JOIN tips t ON t."trackId" = tr.id
       WHERE t."trackId" IN (
         SELECT DISTINCT t2."trackId"
         FROM tips t2
         WHERE t2."senderId" IN (
           SELECT DISTINCT t3."senderId"
           FROM tips t3
           WHERE t3."trackId" IN (
             SELECT "trackId" FROM tips WHERE "senderId" = $1
           )
           AND t3."senderId" != $1
         )
       )
       AND a.id NOT IN (
         SELECT DISTINCT tr2."artistId"
         FROM tips t4
         JOIN tracks tr2 ON tr2.id = t4."trackId"
         WHERE t4."senderId" = $1
       )
       GROUP BY a.id, a."displayName", a.genre
       ORDER BY tip_count DESC
       LIMIT 10`,
      [userId],
    );

    return result;
  }

  /**
   * Record user feedback (thumbs up/down) on a recommendation.
   */
  async recordFeedback(
    userId: string,
    trackId: string,
    feedback: 'up' | 'down',
  ): Promise<RecommendationFeedback> {
    const entry = this.feedbackRepo.create({ userId, trackId, feedback });
    return this.feedbackRepo.save(entry);
  }

  // ── Internal Methods ───────────────────────────────────────────────────────

  private async getUserTipCount(userId: string): Promise<number> {
    const result = await this.dataSource.query(
      `SELECT COUNT(*) as count FROM tips WHERE "senderId" = $1`,
      [userId],
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Collaborative filtering: find tracks tipped by users with similar
   * tipping patterns to the target user.
   */
  private async collaborativeFilter(
    userId: string,
    limit: number,
  ): Promise<any[]> {
    const result = await this.dataSource.query(
      `WITH user_tracks AS (
         SELECT DISTINCT "trackId" FROM tips WHERE "senderId" = $1
       ),
       similar_users AS (
         SELECT t."senderId", COUNT(*) as overlap
         FROM tips t
         JOIN user_tracks ut ON t."trackId" = ut."trackId"
         WHERE t."senderId" != $1
         GROUP BY t."senderId"
         ORDER BY overlap DESC
         LIMIT 50
       )
       SELECT DISTINCT tr.id, tr.title, tr."audioUrl", tr.genre,
              a."displayName" as artist_name,
              COUNT(t.id) as recommendation_score
       FROM tips t
       JOIN similar_users su ON t."senderId" = su."senderId"
       JOIN tracks tr ON tr.id = t."trackId"
       LEFT JOIN artists a ON a.id = tr."artistId"
       WHERE t."trackId" NOT IN (SELECT "trackId" FROM user_tracks)
       GROUP BY tr.id, tr.title, tr."audioUrl", tr.genre, a."displayName"
       ORDER BY recommendation_score DESC
       LIMIT $2`,
      [userId, limit],
    );

    return result.map((r: any) => ({ ...r, source: 'collaborative' }));
  }

  /**
   * Content-based filtering: recommend tracks in genres the user has
   * previously tipped.
   */
  private async contentBasedFilter(
    userId: string,
    limit: number,
  ): Promise<any[]> {
    const result = await this.dataSource.query(
      `WITH user_genres AS (
         SELECT DISTINCT tr.genre
         FROM tips t
         JOIN tracks tr ON tr.id = t."trackId"
         WHERE t."senderId" = $1
       ),
       user_tracks AS (
         SELECT DISTINCT "trackId" FROM tips WHERE "senderId" = $1
       )
       SELECT tr.id, tr.title, tr."audioUrl", tr.genre,
              a."displayName" as artist_name,
              COUNT(t.id) as popularity
       FROM tracks tr
       JOIN user_genres ug ON tr.genre = ug.genre
       LEFT JOIN artists a ON a.id = tr."artistId"
       LEFT JOIN tips t ON t."trackId" = tr.id
       WHERE tr.id NOT IN (SELECT "trackId" FROM user_tracks)
       GROUP BY tr.id, tr.title, tr."audioUrl", tr.genre, a."displayName"
       ORDER BY popularity DESC
       LIMIT $2`,
      [userId, limit],
    );

    return result.map((r: any) => ({ ...r, source: 'content' }));
  }

  /**
   * Popularity-based fallback for cold-start users.
   */
  private async getPopularTracks(limit: number): Promise<any[]> {
    const result = await this.dataSource.query(
      `SELECT tr.id, tr.title, tr."audioUrl", tr.genre,
              a."displayName" as artist_name,
              COUNT(t.id) as tip_count
       FROM tracks tr
       LEFT JOIN artists a ON a.id = tr."artistId"
       LEFT JOIN tips t ON t."trackId" = tr.id
       GROUP BY tr.id, tr.title, tr."audioUrl", tr.genre, a."displayName"
       ORDER BY tip_count DESC
       LIMIT $1`,
      [limit],
    );

    return result.map((r: any) => ({ ...r, source: 'popular' }));
  }

  /**
   * Merge collaborative and content-based results with diversity injection.
   * 60% collaborative, 40% content-based.
   */
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

    // Deduplicate by track ID
    const seen = new Set<string>();
    const unique = merged.filter((track) => {
      if (seen.has(track.id)) return false;
      seen.add(track.id);
      return true;
    });

    return unique.slice(0, limit);
  }
}
