import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
  Index,
  UpdateDateColumn,
} from "typeorm";
import { Track } from "../../tracks/entities/track.entity";

export enum ReleaseStatus {
  PENDING = "pending",
  PUBLISHING = "publishing",
  PUBLISHED = "published",
  FAILED_PERMANENTLY = "failed_permanently",
}

@Entity("scheduled_releases")
@Index(["releaseDate", "isReleased"])
@Index(["status", "retryCount"])
export class ScheduledRelease {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  trackId: string;

  @ManyToOne(() => Track, { onDelete: "CASCADE" })
  @JoinColumn({ name: "trackId" })
  track: Track;

  @Column({ type: "timestamp" })
  releaseDate: Date;

  @Column({ type: "boolean", default: false })
  isReleased: boolean;

  @Column({ type: "boolean", default: true })
  notifyFollowers: boolean;

  @Column({ type: "integer", default: 0 })
  presaveCount: number;

  @Column({
    type: "enum",
    enum: ReleaseStatus,
    default: ReleaseStatus.PENDING,
  })
  status: ReleaseStatus;

  @Column({ type: "integer", default: 0 })
  retryCount: number;

  @Column({ type: "text", nullable: true })
  lastError: string;

  @Column({ type: "timestamp", nullable: true })
  lastAttemptAt: Date;

  @Column({ type: "timestamp", nullable: true })
  nextRetryAt: Date;

  @Column({ type: "timestamp", nullable: true })
  publishedAt: Date;

  @Column({ type: "timestamp", nullable: true })
  failedAt: Date;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: "timestamp", default: () => "CURRENT_TIMESTAMP" })
  updatedAt: Date;
}
