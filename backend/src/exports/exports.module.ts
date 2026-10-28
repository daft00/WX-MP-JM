import { GovernanceModule } from "../governance/governance.module";
import { ThrottlerModule } from "@nestjs/throttler";
import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FamiliesModule } from "../families/families.module";
import { MediaModule } from "../media/media.module";
import { ExportsService } from "./exports.service";
import { ExportsController } from "./exports.controller";
import { BrowserController } from "./browser.controller";
@Module({ imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 10 }]), DatabaseModule, FamiliesModule, MediaModule, GovernanceModule], providers: [ExportsService], controllers: [ExportsController, BrowserController] })
export class ExportsModule {}
