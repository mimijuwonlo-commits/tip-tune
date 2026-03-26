import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThanOrEqual, IsNull, Not } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ScheduledRelease, ReleaseStatus } from "./entities/scheduled-release.entity";
import { PreSave } from "./entities/presave.entity";
import { Track } from "../tracks/entities/track.entity";
import { NotificationsService } from "../notifications/notifications.service";
import { FollowsService } from "../follows/follows.service";
import { NotificationType } from "@/notifications/notification.entity";

@Injectable()
export class ScheduledReleasesService {
  private readonly logger = new Logger(ScheduledReleasesService.name);
  private readonly maxRetries = 3;
  private readonly retryDelayMs = 5000; // 5 seconds

  constructor(
    @InjectRepository(ScheduledRelease)
    private scheduledReleaseRepository: Repository<ScheduledRelease>,
    @InjectRepository(PreSave)
    private preSaveRepository: Repository<PreSave>,
    @InjectRepository(Track)
    private trackRepository: Repository<Track>,
    private notificationsService: NotificationsService,
    private followsService: FollowsService,
  ) {}

  async createScheduledRelease(
    trackId: string,
    releaseDate: Date,
    notifyFollowers: boolean = true,
  ): Promise<ScheduledRelease> {
    const track = await this.trackRepository.findOne({
      where: { id: trackId },
      relations: ["artist"],
    });

    if (!track) {
      throw new NotFoundException("Track not found");
    }

    if (new Date(releaseDate) <= new Date()) {
      throw new BadRequestException("Release date must be in the future");
    }

    // Mark track as scheduled (not publicly visible yet)
    await this.trackRepository.update(trackId, {
      isPublic: false,
    });

    const scheduledRelease = this.scheduledReleaseRepository.create({
      trackId,
      releaseDate: new Date(releaseDate),
      notifyFollowers,
    });

    return this.scheduledReleaseRepository.save(scheduledRelease);
  }

  async getScheduledRelease(id: string): Promise<ScheduledRelease> {
    const release = await this.scheduledReleaseRepository.findOne({
      where: { id },
      relations: ["track", "track.artist"],
    });

    if (!release) {
      throw new NotFoundException("Scheduled release not found");
    }

    return release;
  }

  async getScheduledReleaseByTrackId(
    trackId: string,
  ): Promise<ScheduledRelease | null> {
    return this.scheduledReleaseRepository.findOne({
      where: { trackId, isReleased: false },
      relations: ["track", "track.artist"],
    });
  }

  async updateScheduledRelease(
    id: string,
    releaseDate?: Date,
    notifyFollowers?: boolean,
  ): Promise<ScheduledRelease> {
    const release = await this.getScheduledRelease(id);

    if (release.isReleased) {
      throw new BadRequestException("Cannot update already released track");
    }

    if (releaseDate && new Date(releaseDate) <= new Date()) {
      throw new BadRequestException("Release date must be in the future");
    }

    if (releaseDate) {
      release.releaseDate = new Date(releaseDate);
    }

    if (notifyFollowers !== undefined) {
      release.notifyFollowers = notifyFollowers;
    }

    return this.scheduledReleaseRepository.save(release);
  }

  async cancelScheduledRelease(id: string): Promise<void> {
    const release = await this.getScheduledRelease(id);

    if (release.isReleased) {
      throw new BadRequestException("Cannot cancel already released track");
    }

    // Delete all pre-saves
    await this.preSaveRepository.delete({ trackId: release.trackId });

    // Delete the scheduled release
    await this.scheduledReleaseRepository.delete(id);
  }

  async getUpcomingReleases(limit: number = 20): Promise<ScheduledRelease[]> {
    return this.scheduledReleaseRepository.find({
      where: { isReleased: false },
      relations: ["track", "track.artist"],
      order: { releaseDate: "ASC" },
      take: limit,
    });
  }

  async getArtistScheduledReleases(
    artistId: string,
  ): Promise<ScheduledRelease[]> {
    return this.scheduledReleaseRepository
      .createQueryBuilder("sr")
      .leftJoinAndSelect("sr.track", "track")
      .leftJoinAndSelect("track.artist", "artist")
      .where("artist.id = :artistId", { artistId })
      .andWhere("sr.isReleased = :isReleased", { isReleased: false })
      .orderBy("sr.releaseDate", "ASC")
      .getMany();
  }

  // Cron job runs every minute to check for releases
  @Cron(CronExpression.EVERY_MINUTE)
  async handleScheduledReleases(): Promise<void> {
    this.logger.log("Checking for scheduled releases...");

    try {
      // Find releases that are due and not yet released or failed
      const releasesToPublish = await this.scheduledReleaseRepository.find({
        where: {
          releaseDate: LessThanOrEqual(new Date()),
          isReleased: false,
          status: Not(ReleaseStatus.FAILED_PERMANENTLY),
        },
        relations: ["track", "track.artist"],
        order: { releaseDate: "ASC" },
      });

      if (releasesToPublish.length === 0) {
        this.logger.log("No releases to publish");
        return;
      }

      this.logger.log(
        `Found ${releasesToPublish.length} releases to process`,
      );

      // Process releases with idempotency check
      for (const release of releasesToPublish) {
        await this.processReleaseWithRetry(release);
      }

      // Clean up old failed releases
      await this.cleanupOldFailedReleases();
    } catch (error) {
      this.logger.error(
        `Error in scheduled release job: ${error.message}`,
      );
    }
  }

  /**
   * Process a release with retry logic and idempotency protection
   */
  private async processReleaseWithRetry(
    release: ScheduledRelease,
  ): Promise<void> {
    // Idempotency check - skip if already processing or released
    if (
      release.isReleased ||
      release.status === ReleaseStatus.PUBLISHING
    ) {
      this.logger.debug(
        `Skipping release ${release.id} - already processed or publishing`,
      );
      return;
    }

    // Check if we should retry based on attempt count
    if (release.retryCount >= this.maxRetries) {
      this.logger.warn(
        `Release ${release.id} has exceeded max retries (${this.maxRetries}). Marking as permanently failed.`,
      );
      await this.markAsPermanentlyFailed(release);
      return;
    }

    try {
      // Mark as publishing to prevent duplicate processing
      await this.updateReleaseStatus(
        release.id,
        ReleaseStatus.PUBLISHING,
      );

      this.logger.log(
        `Processing release ${release.id} (attempt ${release.retryCount + 1}/${this.maxRetries})`,
      );

      await this.releaseTrack(release);

      // Success - mark as published
      await this.updateReleaseStatus(
        release.id,
        ReleaseStatus.PUBLISHED,
      );

      this.logger.log(
        `Successfully released track ${release.track.title} (${release.trackId})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to release track ${release.id}: ${error.message}`,
      );

      // Increment retry counter and mark for retry
      await this.handleReleaseFailure(release, error);
    }
  }

  /**
   * Handle release failure with proper state management
   */
  private async handleReleaseFailure(
    release: ScheduledRelease,
    error: Error,
  ): Promise<void> {
    const retryCount = release.retryCount + 1;

    if (retryCount < this.maxRetries) {
      // Schedule for retry
      await this.scheduledReleaseRepository.update(release.id, {
        retryCount,
        lastError: error.message,
        lastAttemptAt: new Date(),
        status: ReleaseStatus.PENDING,
        nextRetryAt: new Date(Date.now() + this.retryDelayMs),
      });

      this.logger.log(
        `Release ${release.id} scheduled for retry #${retryCount}`,
      );
    } else {
      await this.markAsPermanentlyFailed(release);
    }
  }

  /**
   * Mark release as permanently failed after exhausting retries
   */
  private async markAsPermanentlyFailed(
    release: ScheduledRelease,
  ): Promise<void> {
    await this.scheduledReleaseRepository.update(release.id, {
      status: ReleaseStatus.FAILED_PERMANENTLY,
      lastError: `Failed after ${this.maxRetries} attempts`,
      failedAt: new Date(),
    });

    this.logger.error(
      `Release ${release.id} marked as permanently failed`,
    );
  }

  /**
   * Update release status with proper state transition
   */
  private async updateReleaseStatus(
    releaseId: string,
    status: ReleaseStatus,
  ): Promise<void> {
    await this.scheduledReleaseRepository.update(releaseId, {
      status,
      updatedAt: new Date(),
    });
  }

  /**
   * Clean up old failed releases (older than 30 days)
   */
  private async cleanupOldFailedReleases(): Promise<void> {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    );

    const oldFailedReleases = await this.scheduledReleaseRepository.find({
      where: {
        status: ReleaseStatus.FAILED_PERMANENTLY,
        failedAt: LessThanOrEqual(thirtyDaysAgo),
      },
    });

    if (oldFailedReleases.length > 0) {
      this.logger.log(
        `Cleaning up ${oldFailedReleases.length} old failed releases`,
      );

      for (const release of oldFailedReleases) {
        // Reset track visibility if needed
        try {
          await this.trackRepository.update(release.trackId, {
            isPublic: false,
          });
        } catch (error) {
          this.logger.warn(
            `Failed to reset track visibility for ${release.trackId}: ${error.message}`,
          );
        }
      }

      // Archive or delete old failed releases
      await this.scheduledReleaseRepository.delete({
        id: oldFailedReleases.map((r) => r.id),
      });
    }
  }

  private async releaseTrack(release: ScheduledRelease): Promise<void> {
    // Ensure track exists and is in valid state
    const track = await this.trackRepository.findOne({
      where: { id: release.trackId },
      relations: ["artist"],
    });

    if (!track) {
      throw new Error(`Track ${release.trackId} not found`);
    }

    // Mark track as public
    await this.trackRepository.update(release.trackId, {
      isPublic: true,
      publishedAt: new Date(),
    });

    this.logger.log(`Track ${release.trackId} marked as public`);

    // Mark release as completed
    release.isReleased = true;
    release.publishedAt = new Date();
    await this.scheduledReleaseRepository.save(release);

    this.logger.log(
      `Release ${release.id} marked as released`,
    );

    // Notify pre-savers (with error handling)
    try {
      await this.notifyPreSavers(release);
    } catch (error) {
      this.logger.error(
        `Failed to notify pre-savers for release ${release.id}: ${error.message}`,
      );
      // Don't fail the entire release if notifications fail
    }

    // Notify followers if enabled (with error handling)
    if (release.notifyFollowers) {
      try {
        await this.notifyFollowers(release);
      } catch (error) {
        this.logger.error(
          `Failed to notify followers for release ${release.id}: ${error.message}`,
        );
      }
    }

    this.logger.log(
      `Successfully completed release process for track ${release.track.title} (${release.trackId})`,
    );
  }

  private async notifyPreSavers(release: ScheduledRelease): Promise<void> {
    const preSaves = await this.preSaveRepository.find({
      where: { trackId: release.trackId, notified: false },
      relations: ["user"],
    });

    for (const preSave of preSaves) {
      try {
        await this.notificationsService.create({
          userId: preSave.userId,
          type: NotificationType.TRACK_RELEASED,
          title: "Track Released!",
          message: `${release.track.title} by ${release.track.artist.artistName} is now available!`,
          data: {
            trackId: release.trackId,
            artistId: release.track.artist.id,
          },
        });

        preSave.notified = true;
        await this.preSaveRepository.save(preSave);
      } catch (error) {
        this.logger.error(
          `Failed to notify user ${preSave.userId}: ${error.message}`,
        );
      }
    }
  }

  private async notifyFollowers(release: ScheduledRelease): Promise<void> {
    const result = await this.followsService.getFollowers(
      release.track.artist.id,
      { page: 1, limit: 100 },
    );

    const followers = result.data;

    for (const follower of followers) {
      try {
        // Skip if user already pre-saved (they'll get the pre-save notification)
        const hasPreSaved = await this.preSaveRepository.findOne({
          where: {
            userId: follower.id,
            trackId: release.trackId,
          },
        });

        if (!hasPreSaved) {
          await this.notificationsService.create({
            userId: follower.id,
            type: NotificationType.TRACK_RELEASED,
            title: "Track Released!",
            message: `${release.track.title} by ${release.track.artist.artistName} is now available!`,
            data: {
              trackId: release.trackId,
              artistId: release.track.artist.id,
            },
          });
        }
      } catch (error) {
        this.logger.error(
          `Failed to notify follower ${follower.id}: ${error.message}`,
        );
      }
    }
  }

  async getAnalytics(trackId: string) {
    const release = await this.getScheduledReleaseByTrackId(trackId);

    if (!release) {
      throw new NotFoundException("No scheduled release found for this track");
    }

    const totalPreSaves = await this.preSaveRepository.count({
      where: { trackId },
    });

    const notifiedPreSaves = await this.preSaveRepository.count({
      where: { trackId, notified: true },
    });

    const recentPreSaves = await this.preSaveRepository.count({
      where: {
        trackId,
        createdAt: LessThanOrEqual(
          new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        ),
      },
    });

    return {
      trackId,
      releaseDate: release.releaseDate,
      isReleased: release.isReleased,
      totalPreSaves,
      notifiedPreSaves,
      recentPreSaves,
      daysUntilRelease: release.isReleased
        ? 0
        : Math.ceil(
            (release.releaseDate.getTime() - Date.now()) /
              (1000 * 60 * 60 * 24),
          ),
    };
  }
}
