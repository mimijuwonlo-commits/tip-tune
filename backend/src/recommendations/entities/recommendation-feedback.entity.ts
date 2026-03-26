import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('recommendation_feedback')
export class RecommendationFeedback {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  userId: string;

  @Column()
  trackId: string;

  @Column({ type: 'enum', enum: ['up', 'down'] })
  feedback: 'up' | 'down';

  @CreateDateColumn()
  createdAt: Date;
}
