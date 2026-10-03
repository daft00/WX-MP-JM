import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FamiliesModule } from "../families/families.module";
import { EntriesController } from "./entries.controller";
import { EntriesService } from "./entries.service";

@Module({ imports: [DatabaseModule, FamiliesModule], controllers: [EntriesController], providers: [EntriesService] })
export class EntriesModule {}
