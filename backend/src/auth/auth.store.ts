import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MoreThan, QueryFailedError } from "typeorm";
import { DatabaseService } from "../database/database.service";
import { AuthSession, User, publicUser } from "./auth.entities";

@Injectable()
export class AuthStore {
  constructor(private readonly database: DatabaseService) {}

  async createSession(appId: string, openid: string, method: "WECHAT" | "DEV", tokenHash: string, expiresAt: Date) {
    return this.database.transaction(async (manager) => {
      const users = manager.getRepository(User);
      // 不更新已存在用户的昵称或系统角色；唯一索引处理并发首次登录。
      try {
        await users.insert({ id: randomUUID(), wechatAppId: appId, wechatOpenid: openid,
          nickname: method === "DEV" ? `开发用户-${openid}` : "微信用户", avatarText: "我", systemRole: "USER" });
      } catch (error) {
        if (!(error instanceof QueryFailedError) || error.driverError.code !== "ER_DUP_ENTRY") throw error;
      }
      const user = await users.findOneByOrFail({ wechatAppId: appId, wechatOpenid: openid });
      await manager.getRepository(AuthSession).insert({ tokenHash, userId: user.id, authMethod: method, expiresAt });
      return publicUser(user);
    });
  }

  async findSession(tokenHash: string) {
    return this.database.transaction((manager) => manager.getRepository(AuthSession).findOne({
      where: { tokenHash, expiresAt: MoreThan(new Date()) }, relations: { user: true },
    }));
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.transaction((manager) => manager.getRepository(AuthSession).delete({ tokenHash }));
  }
}
