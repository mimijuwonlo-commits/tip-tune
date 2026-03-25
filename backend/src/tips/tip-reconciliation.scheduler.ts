
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TipReconciliationService } from './tip-reconciliation.service';

@Injectable()
export class TipReconciliationScheduler {
  private readonly logger = new Logger(TipReconciliationScheduler.name);

  constructor(private readonly tipReconciliationService: TipReconciliationService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCron() {
    this.logger.log('Starting tip reconciliation job...');
    await this.tipReconciliationService.reconcileAllTracks();
    this.logger.log(`Tip reconciliation job finished.`);
  }
}
