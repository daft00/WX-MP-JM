import { DeletionService } from "./deletion.service";
import { MediaModule } from "../media/media.module";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { DatabaseModule } from "../database/database.module";
import { FamiliesModule } from "../families/families.module";
import { GovernanceService } from "./governance.service";
import { GovernanceController } from "./governance.controller";
import { ConsentGuard } from "./consent.guard";
@Module({ imports: [DatabaseModule, FamiliesModule, MediaModule], controllers: [GovernanceController], exports: [GovernanceService], providers: [DeletionService, GovernanceService, { provide: APP_GUARD, useClass: ConsentGuard }] })
export class GovernanceModule {}
