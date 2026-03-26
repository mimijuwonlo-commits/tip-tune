import { Injectable, Logger } from '@nestjs/common';

export interface StoredEvent {
  sequenceId: number;
  type: string;
  data: any;
  rooms: string[];
  timestamp: Date;
}

@Injectable()
export class EventStoreService {
  private readonly logger = new Logger(EventStoreService.name);
  private events: StoredEvent[] = [];
  private nextSequenceId = 1;
  private readonly maxWindowSize = 1000; // Store up to 1000 recent events

  /**
   * Store a new event and assign a sequence ID
   */
  storeEvent(type: string, data: any, rooms: string[]): StoredEvent {
    const event: StoredEvent = {
      sequenceId: this.nextSequenceId++,
      type,
      data,
      rooms,
      timestamp: new Date(),
    };

    this.events.push(event);

    // Keep only the sliding window of events
    if (this.events.length > this.maxWindowSize) {
      this.events.shift();
    }

    this.logger.debug(`Stored event ${event.sequenceId} (${type}) for rooms: ${rooms.join(', ')}`);
    return event;
  }

  /**
   * Get missed events for a client after a specific sequence ID
   */
  getEventsAfter(sequenceId: number, targetRooms: string[]): StoredEvent[] {
    // Only return events that the client should have access to based on their joined rooms
    return this.events.filter(
      (event) => 
        event.sequenceId > sequenceId && 
        event.rooms.some((room) => targetRooms.includes(room))
    );
  }

  /**
   * Get the latest sequence ID
   */
  getLatestSequenceId(): number {
    return this.nextSequenceId - 1;
  }

  /**
   * Clear the event store (useful for testing)
   */
  clear(): void {
    this.events = [];
    this.nextSequenceId = 1;
  }
}
