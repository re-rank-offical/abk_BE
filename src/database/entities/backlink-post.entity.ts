import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { AuthoritySite } from "./authority-site.entity";

export enum PostStatus {
  PENDING = "PENDING",
  PROCESSING = "PROCESSING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  TIMED_OUT = "TIMED_OUT",
}

@Entity("backlink_posts")
export class BacklinkPost {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid" })
  authoritySiteId: string;

  @ManyToOne(() => AuthoritySite, (site) => site.backlinkPosts, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "authoritySiteId" })
  authoritySite: AuthoritySite;

  @Column()
  title: string;

  @Column({ type: "text" })
  body: string;

  @Column({
    type: "varchar",
    default: PostStatus.PENDING,
  })
  status: PostStatus;

  @Column({ nullable: true })
  publishedUrl?: string;

  @Column({ type: "text", nullable: true })
  errorMessage?: string;

  @Column({ type: "uuid", nullable: true })
  userId: string;

  @CreateDateColumn()
  createdAt: Date;
}
