import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  Repository,
  DataSource,
  MoreThan,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Between,
  IsNull,
  Not,
} from "typeorm";
import { ArtistEvent, EventStatus } from "./artist-event.entity";
import { EventRSVP } from "./event-rsvp.entity";
import {
  CreateArtistEventDto,
  PaginationQueryDto,
  RsvpDto,
  UpdateArtistEventDto,
} from "./events.dto";

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly LIVE_TRANSITION_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  private readonly ENDED_TRANSITION_DELAY_MS = 30 * 60 * 1000; // 30 minutes after end time

  constructor(
    @InjectRepository(ArtistEvent)
    private readonly eventRepo: Repository<ArtistEvent>,
    @InjectRepository(EventRSVP)
    private readonly rsvpRepo: Repository<EventRSVP>,
    private readonly dataSource: DataSource,
  ) {}

  // ─── CRUD ───────────────────────────────────────────────────────────────────

  async create(
    artistId: string,
    dto: CreateArtistEventDto,
  ): Promise<ArtistEvent> {
    const startTime = new Date(dto.startTime);
    if (startTime <= new Date()) {
      throw new BadRequestException("Event start time must be in the future");
    }

    const event = this.eventRepo.create({
      ...dto,
      artistId,
      startTime,
      endTime: dto.endTime ? new Date(dto.endTime) : null,
    });

    return this.eventRepo.save(event);
  }

  async findByArtist(
    artistId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResult<ArtistEvent>> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [data, total] = await this.eventRepo.findAndCount({
      where: { artistId },
      order: { startTime: "ASC" },
      skip,
      take: limit,
    });

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findOne(id: string): Promise<ArtistEvent> {
    const event = await this.eventRepo.findOne({ where: { id } });
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }

  async update(
    id: string,
    artistId: string,
    dto: UpdateArtistEventDto,
  ): Promise<ArtistEvent> {
    const event = await this.findOne(id);

    if (event.artistId !== artistId) {
      throw new ForbiddenException("You can only update your own events");
    }

    if (dto.startTime) {
      const startTime = new Date(dto.startTime);
      if (startTime <= new Date()) {
        throw new BadRequestException("Event start time must be in the future");
      }
      event.startTime = startTime;
    }

    if (dto.endTime) event.endTime = new Date(dto.endTime);

    Object.assign(event, {
      title: dto.title ?? event.title,
      description: dto.description ?? event.description,
      eventType: dto.eventType ?? event.eventType,
      venue: dto.venue ?? event.venue,
      streamUrl: dto.streamUrl ?? event.streamUrl,
      ticketUrl: dto.ticketUrl ?? event.ticketUrl,
      isVirtual: dto.isVirtual ?? event.isVirtual,
    });

    return this.eventRepo.save(event);
  }

  async remove(id: string, artistId: string): Promise<void> {
    const event = await this.findOne(id);
    if (event.artistId !== artistId) {
      throw new ForbiddenException("You can only delete your own events");
    }
    await this.eventRepo.remove(event);
  }

  // ─── RSVP ───────────────────────────────────────────────────────────────────

  async rsvp(
    eventId: string,
    userId: string,
    dto: RsvpDto,
  ): Promise<EventRSVP> {
    const event = await this.findOne(eventId);

    if (event.startTime <= new Date()) {
      throw new BadRequestException("Cannot RSVP to a past event");
    }

    const existing = await this.rsvpRepo.findOne({
      where: { eventId, userId },
    });
    if (existing) {
      throw new ConflictException("You have already RSVPed to this event");
    }

    return this.dataSource.transaction(async (manager) => {
      const rsvp = manager.create(EventRSVP, {
        eventId,
        userId,
        reminderEnabled: dto.reminderEnabled ?? true,
      });
      await manager.save(rsvp);
      await manager.increment(ArtistEvent, { id: eventId }, "rsvpCount", 1);
      return rsvp;
    });
  }

  async unRsvp(eventId: string, userId: string): Promise<void> {
    const event = await this.findOne(eventId);

    if (event.startTime <= new Date()) {
      throw new BadRequestException("Cannot un-RSVP from a past event");
    }

    const rsvp = await this.rsvpRepo.findOne({ where: { eventId, userId } });
    if (!rsvp) throw new NotFoundException("RSVP not found");

    await this.dataSource.transaction(async (manager) => {
      await manager.remove(rsvp);
      await manager.decrement(ArtistEvent, { id: eventId }, "rsvpCount", 1);
    });
  }

  async getAttendees(
    eventId: string,
    query: PaginationQueryDto,
  ): Promise<PaginatedResult<EventRSVP>> {
    await this.findOne(eventId); // ensure event exists

    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const [data, total] = await this.rsvpRepo.findAndCount({
      where: { eventId },
      order: { createdAt: "ASC" },
      skip,
      take: limit,
    });

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── FEED ───────────────────────────────────────────────────────────────────

  async getFeed(
    followedArtistIds: string[],
    query: PaginationQueryDto,
  ): Promise<PaginatedResult<ArtistEvent>> {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    if (!followedArtistIds.length) {
      return { data: [], total: 0, page, limit, totalPages: 0 };
    }

    const [data, total] = await this.eventRepo.findAndCount({
      where: {
        artistId: In(followedArtistIds),
        startTime: MoreThan(new Date()),
      },
      order: { startTime: "ASC" },
      skip,
      take: limit,
    });

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // ─── REMINDER CRON ──────────────────────────────────────────────────────────

  async getEventsForReminder(): Promise<ArtistEvent[]> {
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
    // Window: events starting between now+55min and now+65min (10-min window to avoid missed runs)
    const windowStart = new Date(now.getTime() + 55 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 65 * 60 * 1000);

    return this.eventRepo.find({
      where: {
        startTime: Between(windowStart, windowEnd),
        reminderSent: false,
      },
    });
  }

  async getRsvpsForEvent(
    eventId: string,
    reminderEnabled = true,
  ): Promise<EventRSVP[]> {
    return this.rsvpRepo.find({ where: { eventId, reminderEnabled } });
  }

  async markReminderSent(eventId: string): Promise<void> {
    await this.eventRepo.update(eventId, { reminderSent: true });
  }

  // ─── LIFECYCLE AUTOMATION ───────────────────────────────────────────────────

  /**
   * Cron job to automatically transition event states
   * Runs every 5 minutes to check for events needing state changes
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async automateEventLifecycle(): Promise<void> {
    this.logger.log("Automating event lifecycle transitions...");

    try {
      // Transition upcoming events to LIVE
      const liveCount = await this.transitionUpcomingToLive();
      
      // Transition live events to ENDED
      const endedCount = await this.transitionLiveToEnded();
      
      // Clean up old events
      const cleanupCount = await this.cleanupOldEvents();

      this.logger.log(
        `Lifecycle automation complete: ${liveCount}→LIVE, ${endedCount}→ENDED, ${cleanupCount} cleaned`,
      );
    } catch (error) {
      this.logger.error(
        `Error in event lifecycle automation: ${error.message}`,
      );
    }
  }

  /**
   * Transition upcoming events to LIVE status
   * Events become LIVE within a window around their start time
   */
  async transitionUpcomingToLive(): Promise<number> {
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - this.LIVE_TRANSITION_WINDOW_MS,
    );
    const windowEnd = new Date(
      now.getTime() + this.LIVE_TRANSITION_WINDOW_MS,
    );

    const upcomingEvents = await this.eventRepo.find({
      where: {
        status: EventStatus.UPCOMING,
        startTime: Between(windowStart, windowEnd),
      },
    });

    if (upcomingEvents.length === 0) {
      return 0;
    }

    for (const event of upcomingEvents) {
      try {
        await this.eventRepo.update(event.id, {
          status: EventStatus.LIVE,
          wentLiveAt: new Date(),
        });

        this.logger.log(`Event ${event.id} (${event.title}) transitioned to LIVE`);

        // TODO: Send notifications to RSVP attendees that event is now live
        // await this.notifyAttendeesEventIsLive(event);
      } catch (error) {
        this.logger.error(
          `Failed to transition event ${event.id} to LIVE: ${error.message}`,
        );
      }
    }

    return upcomingEvents.length;
  }

  /**
   * Transition live events to ENDED status
   * Events end after their end time (or start time if no end time) plus a delay
   */
  async transitionLiveToEnded(): Promise<number> {
    const now = new Date();
    const thresholdTime = new Date(
      now.getTime() - this.ENDED_TRANSITION_DELAY_MS,
    );

    // Find live events that should have ended
    const liveEvents = await this.eventRepo.find({
      where: [
        {
          status: EventStatus.LIVE,
          endTime: LessThanOrEqual(thresholdTime),
        },
        {
          status: EventStatus.LIVE,
          endTime: IsNull(),
          startTime: LessThanOrEqual(thresholdTime),
        },
      ],
    });

    if (liveEvents.length === 0) {
      return 0;
    }

    for (const event of liveEvents) {
      try {
        await this.eventRepo.update(event.id, {
          status: EventStatus.ENDED,
          endedAt: new Date(),
        });

        this.logger.log(`Event ${event.id} (${event.title}) transitioned to ENDED`);

        // TODO: Send follow-up notifications or feedback requests
        // await this.notifyAttendeesEventEnded(event);
      } catch (error) {
        this.logger.error(
          `Failed to transition event ${event.id} to ENDED: ${error.message}`,
        );
      }
    }

    return liveEvents.length;
  }

  /**
   * Clean up old events (archive or soft-delete based on age)
   * Prevents database bloat from historical events
   */
  async cleanupOldEvents(daysOld: number = 90): Promise<number> {
    const cutoffDate = new Date(
      Date.now() - daysOld * 24 * 60 * 60 * 1000,
    );

    const oldEvents = await this.eventRepo.find({
      where: {
        status: EventStatus.ENDED,
        endedAt: LessThanOrEqual(cutoffDate),
      },
      take: 100, // Limit to prevent performance issues
    });

    if (oldEvents.length === 0) {
      return 0;
    }

    // For now, just log - could implement soft delete or archival
    this.logger.log(
      `Found ${oldEvents.length} events older than ${daysOld} days for cleanup`,
    );

    // TODO: Implement archival strategy based on business requirements
    // Options: soft delete, move to archive table, compress data, etc.

    return oldEvents.length;
  }

  /**
   * Manually cancel an event (admin/owner action)
   */
  async cancelEvent(eventId: string, userId: string): Promise<ArtistEvent> {
    const event = await this.findOne(eventId);

    // Verify ownership (would need artist validation here)
    // For now, assuming caller has permission

    if (
      event.status === EventStatus.ENDED ||
      event.status === EventStatus.CANCELLED
    ) {
      throw new BadRequestException(
        "Cannot cancel an already ended or cancelled event",
      );
    }

    await this.eventRepo.update(eventId, {
      status: EventStatus.CANCELLED,
    });

    this.logger.log(`Event ${eventId} manually cancelled`);

    // TODO: Notify all RSVP attendees about cancellation
    // await this.notifyAttendeesEventCancelled(event);

    return this.findOne(eventId);
  }
}
