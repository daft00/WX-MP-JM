import { GovernanceModule } from "./governance/governance.module";
import { ExportsModule } from "./exports/exports.module";
import { MediaModule } from "./media/media.module";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { validateEnvironment } from "./config";
import { DatabaseHealthService } from "./database-health.service";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import { FamiliesModule } from "./families/families.module";
import { ChildrenModule } from "./children/children.module";
import { EntriesModule } from "./entries/entries.module";
import { AdminModule } from "./admin/admin.module";

@Module({
  imports: [ConfigModule.forRoot({
    isGlobal: true,
    envFilePath: ".env",
    validate: validateEnvironment,
  }), AuthModule, FamiliesModule, ChildrenModule, EntriesModule, AdminModule, MediaModule, ExportsModule, GovernanceModule],
  controllers: [HealthController],
  providers: [DatabaseHealthService],
})
export class AppModule {}
