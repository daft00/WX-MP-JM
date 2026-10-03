import { Module } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { DatabaseModule } from "../database/database.module";
import { FamiliesController } from "./families.controller";
import { FamiliesService } from "./families.service";

@Module({ imports: [DatabaseModule], controllers: [FamiliesController], providers: [FamiliesService, ThrottlerGuard], exports: [FamiliesService] })
export class FamiliesModule {}
