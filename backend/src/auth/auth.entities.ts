import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, UpdateDateColumn } from "typeorm";

@Entity("users")
export class User {
  @PrimaryColumn({ type: "char", length: 36, charset: "ascii", collation: "ascii_bin" })
  id!: string;

  @Column({ name: "wechat_app_id", type: "varchar", length: 64, select: false })
  wechatAppId!: string;

  @Column({ name: "wechat_openid", type: "varchar", length: 128, select: false })
  wechatOpenid!: string;

  @Column({ type: "varchar", length: 80 })
  nickname!: string;

  @Column({ name: "avatar_text", type: "varchar", length: 16 })
  avatarText!: string;

  @Column({ name: "system_role", type: "enum", enum: ["USER", "SYSTEM_ADMIN"], default: "USER" })
  systemRole!: "USER" | "SYSTEM_ADMIN";

  @CreateDateColumn({ name: "created_at", type: "datetime", precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "datetime", precision: 3 })
  updatedAt!: Date;
}

@Entity("auth_sessions")
export class AuthSession {
  @PrimaryColumn({ name: "token_hash", type: "char", length: 64, charset: "ascii", collation: "ascii_bin" })
  tokenHash!: string;

  @Column({ name: "user_id", type: "char", length: 36, charset: "ascii", collation: "ascii_bin" })
  userId!: string;

  @Column({ name: "auth_method", type: "enum", enum: ["WECHAT", "DEV"] })
  authMethod!: "WECHAT" | "DEV";

  @Column({ name: "expires_at", type: "datetime", precision: 3 })
  expiresAt!: Date;

  @CreateDateColumn({ name: "created_at", type: "datetime", precision: 3 })
  createdAt!: Date;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;
}

export function publicUser(user: User) {
  return {
    id: user.id, nickname: user.nickname, avatarText: user.avatarText,
    ...(user.systemRole === "SYSTEM_ADMIN" ? { systemRole: "SYSTEM_ADMIN" as const } : {}),
  };
}
