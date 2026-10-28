import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { FamiliesModule } from "../families/families.module";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";
import { CosStorage } from "./cos-storage";

@Module({ imports: [DatabaseModule, FamiliesModule], controllers: [MediaController], providers: [MediaService, CosStorage], exports: [MediaService, CosStorage] })
export class MediaModule {}
