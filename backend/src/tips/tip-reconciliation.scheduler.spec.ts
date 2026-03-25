
import { Test, TestingModule } from '@nestjs/testing';
import { TipReconciliationScheduler } from './tip-reconciliation.scheduler';
import { TipsService } from './tips.service';
import { Tip, TipStatus } from './entities/tip.entity';
import { StellarService } from '../stellar/stellar.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

describe('TipReconciliationScheduler', () => {
  let scheduler: TipReconciliationScheduler;
  let tipsService: TipsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TipReconciliationScheduler,
        {
          provide: TipsService,
          useValue: {
            reconcilePendingTips: jest.fn(),
          },
        },
      ],
    }).compile();

    scheduler = module.get<TipReconciliationScheduler>(
      TipReconciliationScheduler,
    );
    tipsService = module.get<TipsService>(TipsService);
  });

  it('should be defined', () => {
    expect(scheduler).toBeDefined();
  });

  describe('handleCron', () => {
    it('should call reconcilePendingTips on the service', async () => {
      await scheduler.handleCron();
      expect(tipsService.reconcilePendingTips).toHaveBeenCalled();
    });
  });
});
