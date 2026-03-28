import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { RecommendationsController } from "./recommendations.controller";
import { RecommendationsService } from "./recommendations.service";
import { RecommendationFeedback } from "./entities/recommendation-feedback.entity";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [TypeOrmModule.forFeature([RecommendationFeedback]), AuthModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsService],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}
