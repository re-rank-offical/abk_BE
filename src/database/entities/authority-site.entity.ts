import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { BacklinkPost } from './backlink-post.entity';

export enum SiteType {
  WORDPRESS = 'WORDPRESS',
  CUSTOM = 'CUSTOM', // 레거시 (기존 데이터 호환)
  TISTORY = 'TISTORY', // 티스토리 (카카오 로그인)
  LINKEDIN = 'LINKEDIN', // LinkedIn 아티클
}

@Entity('authority_sites')
export class AuthoritySite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  siteName: string;

  @Column()
  siteUrl: string;

  @Column({ nullable: true })
  description: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: 0 })
  priority: number;

  // WordPress 연동 정보
  @Column({ nullable: true })
  wordpressApiUrl: string;

  @Column({ nullable: true })
  wordpressUsername: string;

  @Column({ nullable: true })
  wordpressAppPassword: string;

  // 사이트 유형
  @Column({
    type: 'varchar',
    default: SiteType.CUSTOM,
  })
  siteType: SiteType;

  // 로그인 정보
  @Column({ nullable: true })
  loginUrl: string;

  @Column({ nullable: true })
  loginUsernameSelector: string;

  @Column({ nullable: true })
  loginPasswordSelector: string;

  @Column({ nullable: true })
  loginSubmitSelector: string;

  @Column({ nullable: true })
  loginUsername: string;

  @Column({ nullable: true })
  loginPassword: string;

  // 글 작성 페이지 셀렉터
  @Column({ nullable: true })
  writeUrl: string;

  @Column({ nullable: true })
  titleSelector: string;

  @Column({ nullable: true })
  bodySelector: string;

  @Column({ nullable: true })
  submitSelector: string;

  // 세션 쿠키 (로그인 유지용)
  @Column({ type: 'text', nullable: true })
  sessionCookies: string;

  // 소유자
  @Column({ type: 'uuid', nullable: true })
  userId: string;

  @OneToMany(() => BacklinkPost, (post) => post.authoritySite)
  backlinkPosts: BacklinkPost[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
