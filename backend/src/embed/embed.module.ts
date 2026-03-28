import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { EmbedView } from "./entities/embed-view.entity";
import { EmbedService } from "./embed.service";
import { EmbedController } from "./embed.controller";
import { Track } from "../tracks/entities/track.entity";

@Module({
  imports: [TypeOrmModule.forFeature([EmbedView, Track])],
  providers: [EmbedService],
  controllers: [EmbedController],
  exports: [EmbedService],
})
export class EmbedModule {}
