import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PlayCountService } from "./play-count.service";
import { PlayCountController } from "./play-count.controller";
import { TrackPlay } from "./track-play.entity";
import { Track } from "../tracks/entities/track.entity";

@Module({
  imports: [TypeOrmModule.forFeature([TrackPlay, Track])],
  controllers: [PlayCountController],
  providers: [PlayCountService],
  exports: [PlayCountService],
})
export class PlayCountModule {}
