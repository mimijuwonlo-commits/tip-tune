import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { io, Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TipVerifiedEvent } from '../src/tips/events/tip-verified.event';
import { Tip } from '../src/tips/entities/tip.entity';
import { EventStoreService } from '../src/websocket/event-store.service';

describe('WebSocket Delivery (Integration)', () => {
  let app: INestApplication;
  let eventEmitter: EventEmitter2;
  let eventStore: EventStoreService;
  let port: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    // Get a random available port or use a specific one for testing
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        resolve();
      });
    });

    eventEmitter = app.get<EventEmitter2>(EventEmitter2);
    eventStore = app.get<EventStoreService>(EventStoreService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    eventStore.clear();
  });

  const createClient = (namespace: string = '/tips'): ClientSocket => {
    return io(`http://localhost:${port}${namespace}`, {
      transports: ['websocket'],
      autoConnect: true,
    });
  };

  it('should replay missed events upon reconnection with lastSequenceId', (done) => {
    const artistId = 'artist-123';
    const client = createClient();
    let sequenceId1: number;

    client.on('connected', (data) => {
      // Join artist room
      client.emit('join_artist_room', { artistId });
    });

    client.on('joined_room', (data) => {
      if (data.artistId === artistId) {
        // Trigger first tip
        const tip1 = {
          id: 'tip-1',
          artistId: artistId,
          amount: 10,
          asset: 'XLM',
          createdAt: new Date(),
        } as Tip;
        eventEmitter.emit('tip.verified', new TipVerifiedEvent(tip1, 'user-1'));
      }
    });

    client.on('tip_notification', (notif) => {
      if (notif.data.tipId === 'tip-1') {
        sequenceId1 = notif.sequenceId;
        expect(sequenceId1).toBe(1);

        // Disconnect client
        client.disconnect();

        // Trigger second tip while disconnected
        const tip2 = {
          id: 'tip-2',
          artistId: artistId,
          amount: 20,
          asset: 'XLM',
          createdAt: new Date(),
        } as Tip;
        
        // Use a small timeout to ensure disconnect is processed if needed
        setTimeout(() => {
          eventEmitter.emit('tip.verified', new TipVerifiedEvent(tip2, 'user-1'));

          // Reconnect with lastSequenceId
          const client2 = io(`http://localhost:${port}/tips`, {
            transports: ['websocket'],
            query: { lastSequenceId: sequenceId1.toString() }
          });

          client2.on('connected', () => {
             // Join room again with lastSequenceId
             client2.emit('join_artist_room', { artistId, lastSequenceId: sequenceId1 });
          });

          client2.on('tip_notification', (notif2) => {
            if (notif2.data.tipId === 'tip-2') {
              expect(notif2.sequenceId).toBe(2);
              client2.disconnect();
              done();
            }
          });
        }, 100);
      }
    });
  });

  it('should not replay events from other rooms', (done) => {
    const artistId1 = 'artist-1';
    const artistId2 = 'artist-2';
    const client = createClient();
    
    client.on('connected', () => {
      client.emit('join_artist_room', { artistId: artistId1 });
    });

    client.on('joined_room', () => {
      // Trigger tip for artist 2 (should not be received by client in artist 1 room)
      const tip2 = {
        id: 'tip-artist-2',
        artistId: artistId2,
        amount: 5,
        asset: 'XLM',
        createdAt: new Date(),
      } as Tip;
      eventEmitter.emit('tip.verified', new TipVerifiedEvent(tip2, 'user-1'));

      // Trigger tip for artist 1
      const tip1 = {
        id: 'tip-artist-1',
        artistId: artistId1,
        amount: 10,
        asset: 'XLM',
        createdAt: new Date(),
      } as Tip;
      
      setTimeout(() => {
        eventEmitter.emit('tip.verified', new TipVerifiedEvent(tip1, 'user-1'));
      }, 100);
    });

    let receivedTips = 0;
    client.on('tip_notification', (notif) => {
      receivedTips++;
      expect(notif.data.artistId).toBe(artistId1);
      
      if (receivedTips === 1) {
        // Disconnect and test replay logic filter
        client.disconnect();
        
        const client2 = io(`http://localhost:${port}/tips`, {
          transports: ['websocket']
        });

        client2.on('connected', () => {
          // Reconnect to artist 1 but with sequence 0
          client2.emit('join_artist_room', { artistId: artistId1, lastSequenceId: 0 });
        });

        let replayedTips = 0;
        client2.on('tip_notification', (notif2) => {
          replayedTips++;
          expect(notif2.data.artistId).toBe(artistId1);
          // Only tip-artist-1 should be replayed for this room
          if (replayedTips === 1) {
            setTimeout(() => {
              expect(replayedTips).toBe(1);
              client2.disconnect();
              done();
            }, 500);
          }
        });
      }
    });
  });
});
