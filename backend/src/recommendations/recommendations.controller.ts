import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RecommendationsService } from './recommendations.service';

@ApiTags('Recommendations')
@Controller('api/recommendations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RecommendationsController {
  constructor(private readonly service: RecommendationsService) {}

  @Get('tracks')
  @ApiOperation({ summary: 'Get personalized track recommendations' })
  async getTrackRecommendations(
    @Request() req: any,
    @Query('limit') limit?: number,
  ) {
    const userId = req.user?.id || req.user?.sub;
    return this.service.getTrackRecommendations(userId, limit || 20);
  }

  @Get('artists')
  @ApiOperation({ summary: 'Get artist recommendations' })
  async getArtistRecommendations(@Request() req: any) {
    const userId = req.user?.id || req.user?.sub;
    return this.service.getArtistRecommendations(userId);
  }

  @Post('feedback')
  @ApiOperation({ summary: 'Submit recommendation feedback (thumbs up/down)' })
  async submitFeedback(
    @Request() req: any,
    @Body() body: { trackId: string; feedback: 'up' | 'down' },
  ) {
    const userId = req.user?.id || req.user?.sub;
    return this.service.recordFeedback(userId, body.trackId, body.feedback);
  }
}
