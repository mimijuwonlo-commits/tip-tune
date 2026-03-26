import { Module } from '@nestjs/common';
import { WebSocketGateway } from './websocket.gateway';
import { EventStoreService } from './event-store.service';

@Module({
  providers: [WebSocketGateway, EventStoreService],
  exports: [WebSocketGateway, EventStoreService],
})
export class WebSocketModule {}
